# Pinpoint confidence calibration on real binaries

Measurement-only investigation. No production semantics changed in this branch.
Question: does the #9418 proposal (require `independentGroups >= 3` for `likely`)
hold up on a real-binary labelled corpus, or is one DSDA case deciding a global
policy? Both the benefit (prevented false strong verdicts) and the cost
(correct likelies downgraded to ambiguous) are counted below.

## Dataset

- Binaries: BattleCats (28 MB), TsumTsum (46 MB), YWP (63 MB) via
  `npm run fixtures:large` (public GitHub raw, size + git-blob-sha1 verified).
- Queries: 426 total from `tests/fixtures/pinpoint-confidence-queries.json`,
  derived with the same unique-name rule as #9413/`accuracy-base`:
  exact-name 230 (BattleCats 120, TsumTsum 60, YWP 50),
  remembered/partial-name 196 (86 + 60 + 50). Same query identity as #9413,
  so results compare directly (there: exact 229/230 top-1, partial 53 top-1,
  65 outside top-4, 54 not-found — reproduced here: exact 229/230,
  partial top-1 53, not-found 54).
- Labels are independent ground truth (unique field names in the image).
  Hex's own top-1 is never used as a label.
- DSDA-Doom ARM64 holdout measured separately (location path, `hp`):
  top offset 148, truth offset 196 rank 4/8, p 0.9157, margin 3.815 (45.4x),
  groups 2, analyze calls 18. OLD likely → NEW ambiguous, ranking unchanged.

## OLD

Baseline (pre-#9418): likely = p>=0.85 AND margin>=ln(4), no group requirement.
Confirmed unchanged. Field corpus (426 queries, 0 errors, 0 no-result):

- correct: confirmed 151, likely 74, ambiguous 57
- wrong: confirmed 49, likely 26, ambiguous 69
- false strong (wrong confirmed + wrong likely): **75**

## NEW

#9418: likely additionally requires `independentGroups >= 3`. Confirmed unchanged.

- correct: confirmed 151, likely 5, ambiguous 126
- wrong: confirmed 49, likely 18, ambiguous 77
- false strong: **67** (prevented 8 vs OLD)

Counterfactuals (measurement-only, pre-specified, never implemented):
Policy B (OLD + likely requires verified): false strong 69.
Policy C (OLD + groups==2 likely requires getter/setter-verified): false strong 69.
Both are dominated by NEW on this corpus (less prevention, same correct cost).

## Cost

NEW downgrades 77 OLD likelies to ambiguous:

- prevented false-likely (wrong likely → ambiguous): **8**
- downgraded correct likely → ambiguous: **69** (68 exact-name + 1 partial)
- exact correct coverage: OLD confirmed 131 / likely 70 / ambiguous 28
  → NEW confirmed 131 / likely 2 / ambiguous 96
- partial correct coverage: OLD 20 / 4 / 29 → NEW 20 / 3 / 30
- partial-present (truth is a candidate, 142 queries): false strong 43 → 43
  (zero reduction where the truth is decidable)
- All 8 prevented cases are partial not-found single-candidate queries
  (truth absent, 1 candidate, e.g. `companion view`, `view frame`,
  `end timestamp`, `url parameters`, `body text` — see `preventedDetail`
  in `summary.json`). None is a present-candidate decision.

So: 8 prevented wrong at the price of 69 downgraded correct (~8.6 correct
per prevented wrong). Exact-name likely coverage collapses 70 → 2 for zero
exact benefit (exact false strong was already 0).

## Groups

Top-1 observed accuracy and strong counts per independent-group count:

- groups=1: n=28, accuracy 57.1%, OLD strong 7 (false 2) → NEW strong 0 (false 0)
- groups=2: n=121, accuracy 77.7%, OLD strong 70 (false 6) → NEW strong 0 (false 0)
- groups=3+: n=277, accuracy 62.1%, OLD strong 223 (false 67) → NEW strong 223 (false 67)

Key conditional: P(correct | OLD likely AND groups=2) = **91.4% (64/70)**.
Split by regime: exact 63/63 (**100%**), partial 1/7 (14.3%).
67 of 75 OLD false-strong verdicts (89%) already have 3+ groups and are
untouched by NEW. The remaining NEW likely pool is 23 cases, 5 correct
(21.7% accuracy) — all `dataflow+metadata+structural`.

## 2-group breakdown

OLD likely with 2 groups (70 cases) by group combination:

- `metadata+structural`: n=68, correct 64, wrong 4, accuracy 94.1%
- `dataflow+metadata`: n=2, correct 0, wrong 2, accuracy 0% (n=2, weak evidence)
- `structural+dataflow` (the DSDA location pattern): **0 field-path cases**

Not "all 2 groups are dangerous": `metadata+structural` 2-group likely is
94% correct (100% on exact). The dangerous 2-group evidence is thin
(`dataflow+metadata`, n=2). The DSDA pattern has no field-path samples here.

## Margin

Margin-ratio buckets (field, correct vs wrong, group splits):

- <4x: n=98, correct 29, wrong 69 (g2 30, g3+ 54)
- 4–10x: n=9, correct 4, wrong 5 (g2 1, g3+ 8)
- 10–20x: n=13, correct 0, wrong 13 (all g3+)
- 20–50x: n=18, correct 2, wrong 16 (all g3+)
- \>50x: n=288, correct 247, wrong 41 (g2 90, g3+ 184)

High-margin-wrong exists beyond DSDA: 10–50x wrong cases are all 3+ groups
(29 cases NEW cannot catch). Six field wrong 2-group cases at >=20x are all
partial single-candidate not-found queries (see `highMarginWrongG2`).

## Exact-name

Exact corpus is already strong (229/230 top-1, 99.6%) with zero false strong
under both policies. NEW changes no exact accuracy (ambiguous is not wrong)
and no confirmed coverage (131 → 131), but likely coverage drops 70 → 2:
68 correct exact likelies become ambiguous. That is pure abstention cost with
no exact benefit.

## Partial-name

196 queries: top-1 correct 53, not-found 54 (truth absent — kept in every
denominator, never dropped). Candidate-present subset (142): accuracy 37.3%,
false strong 43 → 43 under NEW (no change). The 8 prevented false-likely are
all in the not-found subset (single admitted candidate, truth absent).

## Decision evidence

OLD 2-group likely: n=70, correct 64, wrong 6.
NEW: prevented false-likely = 8 (6 partial g2-wrong + 2 g1-wrong, all
single-candidate not-found); downgraded correct likely = 69
(63 exact g2 + 5 exact g1 + 1 partial).
2-group likely is 91% correct overall and 100% correct (63/63) on exact-name.
89% of OLD false-strong verdicts are 3-group cases NEW does not address.
On partial-present queries NEW changes nothing (43 → 43).

Classification: **too strict** as a global rule in its current form — it
removes 69 correct likelies (collapsing exact likely coverage 70 → 2) to
prevent 8 wrong likelies, all single-candidate not-found cases, while leaving
the 43 present-candidate false-strong verdicts and all 49 wrong confirmeds
untouched. The DSDA holdout itself is fixed (likely → ambiguous, ranking
unchanged), and the data supports narrower alternatives worth measuring
before a global rollout — e.g. applying the groups gate to partial/free
queries only (exact 2-group likely is 63/63), or exempting the
`metadata+structural` combination (64/68 correct) — but those alternatives
are not implemented or tuned here (B/C as pre-specified show no advantage:
both prevent 6 at the same 69 correct cost).
Caveats: `dataflow+metadata` n=2; DSDA location pattern n=1; scores below
are uncalibrated confidence scores, not frequency probabilities (the >=0.99
bucket observes only 60.9% top-1 accuracy, non-monotone across buckets —
see `scoreBuckets`).
