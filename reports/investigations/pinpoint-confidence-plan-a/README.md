# Pinpoint confidence Plan A — current-main recalibration

## Conclusion

The fresh current-main replay selects **policy D**: keep the global three-
independent-group rule, but allow a field-only `likely` verdict for the
strictly validated two-group pair `{metadata, structural}`. Policy D is
already the production behavior on current `main` via #9448. This change set
adds the recalibration evidence, machine-readable comparison, oracle analysis,
and the Jev eligibility boundary; it does not duplicate or alter candidate
generation, fusion, ranking, or the production field rule.

The decision is evidence-aware rather than a corpus-specific score tweak. In
the two-group replay, metadata+structural was correct in 55/55 strong-eligible
rows; the other observed two-group combination, metadata+dataflow, was correct
in 0/2. The production gate validates the group projection from evidence
items, rejects unknown/duplicate/disagreeing metadata, and remains opt-in to
the field path. `confirmed` still requires three groups.

## Scope and provenance

This is a new real-binary collection on current `main`, not a reuse of the
#9432 headline. The collection was made at measurement head
`08d5580c96c8831e13fea9242c858fbc8c1a3212`, with current `main`
`4ce9459d2f51163e20abb005e222bd93d88771e7` as an ancestor. The candidate,
fusion, ranking, and verdict production blobs (`js/evidence.js`,
`js/pinpoint.js`, and `js/pinpoint-legacy.js`) were byte-identical between the
measurement head and current `main`; see
[`current-main-p4/measurement-context.json`](current-main-p4/measurement-context.json).
The measurement head adds only report/replay/test/Jev-boundary tooling outside
that production surface.

The one-pass collection contains 426 labelled field queries (230 exact and 196
partial), plus one separately reported DSDA location holdout. All policy,
taxonomy, oracle, and Jev numbers below use the full **field denominator
N=426** unless a different denominator is shown. The DSDA row is never folded
into a field rate.

## Current-main calibration

| Population | N | Truth candidate present | Candidate recall | Top-1 correct | Top-1 accuracy |
| --- | ---: | ---: | ---: | ---: | ---: |
| All field | 426 | 426/426 | 100.0% | 282 | 66.2% |
| Exact | 230 | 230/230 | 100.0% | 229 | 99.6% |
| Partial | 196 | 196/196 | 100.0% | 53 | 27.0% |

Thus #9437 restores all 54 partial candidates that were absent in the old
#9432 artifact (142/196 → 196/196). It does not repair their ordering: the
current and historical top-1 counts are both 282/426. The old/current
machine-readable transition, including every recovered query, is in
[`current-main-p4/old-vs-current.json`](current-main-p4/old-vs-current.json).

The truth-rank distribution is top-1 282, rank 2–4 101, rank 5–8 32, rank 9+
11, and not-found 0. The top-row independent-group distribution is one group
28, two groups 121, and three-or-more groups 277. The largest evidence
compositions are metadata+structural 119 and
dataflow+metadata+structural 277; the complete composition and code counts are
in [`summary.json`](current-main-p4/summary.json).

Scores are fusion scores, not calibrated probabilities: median 0.998680, with
168 correct top-1 rows out of 275 in the `>=0.99` bucket. Finite score-margin
rows are 243/426 (median 1.846); 183 have an infinite margin. These results
keep ranking and confidence as separate decisions.

Under selected policy D, the all-field verdict counts are:

| Verdict | Correct | Incorrect |
| --- | ---: | ---: |
| confirmed | 150 | 49 |
| likely | 61 | 18 |
| ambiguous | 71 | 77 |
| not-found/none | 0 | 0 |

Therefore correct confirmed = 150/426, correct likely = 61/426, correct strong
= **211/426 (49.5%)**, false confirmed = 49/426, false likely = 18/426, and
false-strong = **67/426**. Exact D strong is 187/230 (130 confirmed + 57
likely); partial D strong is 24/196 (20 + 4).

## Policy comparison

The policies reuse the same candidate set, scores, margins, identifying gates,
and confirmed rule. Only admission of a `likely` verdict differs.

| Policy | Two-group rule | Correct strong | False confirmed | False likely | False strong | Strong coverage | Exact strong | Partial strong | Present / not-found | Group=2 correct/false strong | Group≥3 correct/false strong |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| A | global ≥3 | 156 | 49 | 18 | 67 | 36.6% | 133/230 | 23/196 | 426/0 | 0/0 | 156/67 |
| B | legacy any group | 215 | 49 | 20 | 69 | 50.5% | 191/230 | 24/196 | 426/0 | 55/2 | 156/67 |
| C | partial ≥3; exact ≥2 | 210 | 49 | 18 | 67 | 49.3% | 187/230 | 23/196 | 426/0 | 54/0 | 156/67 |
| **D** | **≥3 or exact metadata+structural** | **211** | **49** | **18** | **67** | **49.5%** | **187/230** | **24/196** | **426/0** | **55/0** | **156/67** |
| E | singleton two-group | 210 | 49 | 18 | 67 | 49.3% | 187/230 | 23/196 | 426/0 | 54/0 | 156/67 |

Relative to the current global gate A, D is **+55 correct strong and +0
false-strong** (`+54` exact, `+1` partial). It removes the measured
over-broad-gate loss without permitting the two wrong dataflow combinations.
The legacy any-group rule gains one more correct strong row but also introduces
two two-group false-strong rows; it is not adopted. The exact-only gate is a
mode heuristic rather than an evidence provenance rule, and the singleton
alternative confuses cardinality with independence.

## Failure taxonomy: ranking versus confidence

The classes are mutually exclusive (wrong strong is classified as class 4,
not also as a ranking-only weak error). Counts are shown for A → selected D:

| Class | A | D |
| --- | ---: | ---: |
| 1. Truth candidate absent | 0 | 0 |
| 2. Truth present, wrong top-1, non-strong | 77 | 77 |
| 3. Correct top-1, confidence too weak | 71 | 71 |
| 4. Wrong top-1, strong verdict | 67 | 67 |
| 5. Correct candidate/ranking rejected only by broad independence gate | 55 | 0 |
| 6. Other | 0 | 0 |
| Correct top-1 with strong verdict | 156 | 211 |

The 144 wrong top-1 rows are ranking failures, not confidence failures. The
71 correct-but-ambiguous rows are the remaining calibration abstention gap.
Changing a confidence threshold cannot safely fix either wrong ordering or
missing evidence.

## Oracle ceilings

These oracles use only the existing candidate lattice and recorded evidence;
they do not train a model, add binary analysis, or call Jev.

| Oracle | Result (N=426) | Interpretation |
| --- | ---: | --- |
| Candidate oracle | 426/426 = 100.0% | Truth is selectable whenever it is already in the lattice. |
| Observed ranking | 282/426 = 66.2% | Current top-1 accuracy. |
| Conservative ranking-information ceiling | 282/426 = 66.2% | No wrong top has a truth-only verified/non-metadata identifying token that establishes a safe generic rerank direction. |
| Confidence oracle | 282/426 = 66.2% strong, 0 false-strong | If top-1 correctness were known, only correct tops would be marked strong. |
| Selected D | 211/426 = 49.5% correct strong, 67 false-strong | 71 correct-top calibration-abstention gap remains. |

The loss decomposition is 0 candidate-recall loss, 144 ranking loss after
candidate recall, 71 confidence-calibration loss after a correct top-1, and 67
residual false-strong outcomes. Of wrong-top rows, 22 have no captured
top/truth evidence differential and 122 differ only by metadata/weak signals;
the recorded features therefore do not justify a generic reranker.

## Jev eligibility boundary

[`js/pinpoint-jev-eligibility.js`](../../../js/pinpoint-jev-eligibility.js)
defines the cheap, machine-testable boundary:

```
candidate lattice
  -> deterministic ranking/evidence
  -> unresolved ambiguity only
  -> Jev assist
  -> fail-closed verdict
```

Eligibility requires: partial query, complete deterministic candidate lattice,
at least two candidates, local `ambiguous` verdict, unresolved top/runner
evidence signatures, and a caller-supplied `highImpact=true`. Exact queries,
strong local results, candidate recall failures, parser/lifter/function-extent
failures, decisive evidence, malformed input, and low-impact requests are
rejected. Jev timeout, invalid response, or low confidence must return the
unmodified local result through the fallback contract.

With every corpus row provisionally marked high-impact (an upper bound, not a
production default), 61/426 shapes are eligible: 19 currently correct tops
and 42 wrong tops. Of the 215 non-resolved selected-D outcomes, 154 are
outside this boundary and are not Jev targets under this contract. The full
row-level decision and reason counts are in
[`jev-eligibility-analysis.json`](current-main-p4/jev-eligibility-analysis.json).

## Production and performance decision

Current `main` already contains the minimal P4 production implementation from
#9448. It is field-only and opt-in; default/location paths retain the global
three-group gate. No candidate-generation, scoring, fusion, ranking, parser,
lifter, or function-extent code is changed here. The trusted-pair check is
O(number of evidence items in the already selected top fusion), never
O(candidate set) and never a global deep analysis.

A decision-only microbenchmark (200,000 synthetic calls × 5, Node v24.20.0)
measured a 1.49 µs median for the direct baseline and 2.97 µs for the field
helper (about +1.48 µs). This is not a whole-binary benchmark; the production
change does not repeat analysis, call an external service, or add work to
candidate generation/ranking. No runtime/complexity regression was observed
outside this bounded decision branch.

## Artifacts and reproduction

All current-main artifacts are under
[`current-main-p4/`](current-main-p4/):

- `measurement.json` — fixture, query, product, collector, and policy hashes.
- `measurement-context.json` — current-main ancestry and production blob
  identity proof.
- `rows.jsonl` — one field row per query plus the DSDA holdout, including
  candidate snapshots, scores, margins, evidence, groups, and verdicts.
- `summary.json`, `policy-comparison.json` — requested aggregates and policy
  subsets.
- `old-vs-current.json` — #9432 versus current-main transition.
- `failure-taxonomy.json`, `failure-rows.jsonl` — mutually exclusive failure
  classes.
- `oracle-ceiling.json`, `ranking-oracle-classification.json` — ceiling and
  loss decomposition.
- `jev-eligibility-analysis.json` — eligibility predicate replay.

The denominator contract is documented in
[`denominator-contract.md`](denominator-contract.md). Reproduce the one-pass
collection and offline replay with:

```sh
npm run fixtures:large
node --max-old-space-size=8000 scripts/measure-pinpoint-confidence.mjs \
  --out reports/investigations/pinpoint-confidence-plan-a/current-main-p4
node scripts/aggregate-pinpoint-confidence-plan-a.mjs \
  --out reports/investigations/pinpoint-confidence-plan-a/current-main-p4
node --test tests/investigate-pinpoint-confidence-plan-a.mjs
```

The production attestation script must be run from a clean exact head with
`--evidence-out` directed to persistent workspace evidence. It replays all 426
recorded field decisions without repeating binary analysis.
