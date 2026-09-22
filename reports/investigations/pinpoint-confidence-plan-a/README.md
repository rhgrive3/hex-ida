# Pinpoint confidence Plan A — current-main recalibration

## Scope and evidence identity

This report re-runs the real-binary field measurement on `origin/main`
`de1bfbb8a58b475b2794386788d2da5c68e218ae`, rather than reusing a headline
from an earlier artifact. The raw evidence is
[`current-main-p1/rows.jsonl`](current-main-p1/rows.jsonl): 426 labelled field
queries (230 exact, 196 partial) plus one separately reported DSDA location
holdout. The collection ran the production field pipeline once per field query;
policy comparison, taxonomy, oracle, and Jev analysis are offline replays and
add no binary analysis work.

`current-main-p1/measurement.json` binds the product SHA/tree, fixture and
query SHA-256s, Node version, and collector/policy script hashes. All headline
field numbers below use **N=426**; the DSDA row is not silently folded into a
field denominator.

## Current-main recalibration

| Population | N | Truth candidate present | Top-1 correct | Candidate recall | Top-1 accuracy |
| --- | --: | --: | --: | --: | --: |
| All field | 426 | 426 | 282 | 100.0% | 66.2% |
| Exact | 230 | 230 | 229 | 100.0% | 99.6% |
| Partial | 196 | 196 | 53 | 100.0% | 27.0% |

The truth-rank distribution is 282 top-1, 101 rank 2–4, 32 rank 5–8, 11 rank
9+, and 0 not-found. The current group's distribution is 28 one-group, 121
two-group, and 277 three-or-more-group tops. Top evidence-group combinations
are recorded in `summary.json`; the largest are `metadata+structural` (119
rows) and `dataflow+metadata+structural` (277 rows). Per-candidate score,
margin, group, and applied-evidence snapshots are retained in the JSONL rather
than reduced to a single aggregate.

The raw score is an uncalibrated fusion score, not an empirical probability.
Its median is 0.9987, while the `>=0.99` bucket has only 168 correct top-1s of
275 rows. That is why score/ranking and confidence verdict must remain separate
concepts.

## Historical vs current comparison

`old-vs-current.json` compares the initial #9432 committed row artifact at
`55a2dfc79a7d4a1028219d565518ff2996037f5b` with this fresh run.

| Metric | Historical | Current-main | Delta |
| --- | --: | --: | --: |
| Field truth present (N=426) | 372 | 426 | +54 |
| Partial truth present (N=196) | 142 | 196 | +54 |
| Exact truth present (N=230) | 230 | 230 | 0 |
| Top-1 correct (N=426) | 282 | 282 | 0 |
| P1 correct-strong (N=426) | 156 | 156 | 0 |
| P1 false-strong (N=426) | 67 | 67 | 0 |

Thus the bounded lexical recall lane restores all 54 formerly absent partial
truth candidates, but it does **not** fix their ranking: no top candidate
changed in the row comparison. In the old candidate-present subset, 24
false-strong cases were masked by absent truth candidates; current-main places
those truth candidates back in the lattice, where they remain ranking failures.
This is a recall improvement, not evidence that confidence became safer or
that ranking was repaired.

## 3-group policy comparison

All policies retain the existing score, margin, identifying-evidence, and
confirmed conditions. They differ only in `likely` group admission.

| Policy | `likely` admission | Correct confirmed | Correct likely | Correct strong | False confirmed | False likely | False strong | Strong coverage |
| --- | --- | --: | --: | --: | --: | --: | --: | --: |
| A | Current global `groups >= 3` | 150 | 6 | 156 | 49 | 18 | 67 | 36.6% |
| B | Historical: any group count | 150 | 65 | 215 | 49 | 20 | 69 | 50.5% |
| C | Partial `>=3`; exact `>=2` | 150 | 60 | 210 | 49 | 18 | 67 | 49.3% |
| D | `>=3`, or exactly metadata + structural | 150 | 61 | **211** | 49 | 18 | **67** | **49.5%** |
| E | `>=3`, or singleton two-group candidate | 150 | 60 | 210 | 49 | 18 | 67 | 49.3% |

Policy D is selected. Relative to A it changes **only** correct likely verdicts:
`+55` correct strong (`+54` exact, `+1` partial), `+0` false-confirmed,
`+0` false-likely, and `+0` false-strong. The selected policy's required
subsets are:

| D subset | N | Correct strong | False strong |
| --- | --: | --: | --: |
| Exact | 230 | 187 | 0 |
| Partial | 196 | 24 | 67 |
| Truth candidate present | 426 | 211 | 67 |
| Truth candidate not-found | 0 | 0 | 0 |
| Independent groups = 2 | 121 | 55 | 0 |
| Independent groups >= 3 | 277 | 156 | 67 |

The decisive 2-group `likely` pool has 57 rows: 55
`metadata+structural` are correct (54 exact, one partial), while two
`dataflow+metadata` rows are wrong. The DSDA `dataflow+structural` location
holdout remains ambiguous because the exemption is field-only and does not
admit that pair.

This is not a corpus-tuned score threshold. D has no label, binary, score, or
margin exception. It recognizes one provenance fact: independently recorded
metadata and structural observations can be adequate for field `likely`, while
dataflow must not be substituted for either source. The implementation requires
an item-backed, canonical, duplicate-free two-element group projection that
agrees with the derived groups. `confirmed` still requires three groups;
malformed or count-only input fails closed.

## Failure taxonomy

Classes are mutually exclusive by priority. A wrong strong top is class 4,
not also class 2.

| Class | A current global gate | D selected policy |
| --- | --: | --: |
| 1. Truth candidate absent | 0 | 0 |
| 2. Truth present, wrong top-1, non-strong | 77 | 77 |
| 3. Correct top-1, confidence too weak | 71 | 71 |
| 4. Wrong top-1 with strong verdict | 67 | 67 |
| 5. Correct candidate/ranking rejected only by over-broad group policy | 55 | 0 |
| Resolved correct strong | 156 | 211 |

D removes class 5; it does not pretend that classes 2 or 4 are confidence
problems. The dominant remaining source is ranking (144 rows total), followed
by calibration abstention (71 correct tops not strong).

## Oracle ceilings

The oracle is deliberately bounded to the current candidate lattice and
recorded local evidence. It does not train an ML model, inject a new heuristic,
or call Jev.

| Oracle | Ceiling / result | Meaning |
| --- | ---: | --- |
| Candidate oracle | 426/426, 100.0% | Always select truth if it is already a candidate. |
| Observed ranking | 282/426, 66.2% | Current top-1. |
| Conservative ranking-information ceiling | 282/426, 66.2% | No wrong top has a truth-only verified or non-metadata identifying evidence token that establishes a safe generic rerank direction. |
| Confidence oracle | 282/426, 66.2% strong with 0 false-strong | Know whether current top-1 is right, then make only correct tops strong. |
| Selected D | 211/426, 49.5% correct strong; 67 false-strong | 71-row calibration-abstention gap to the ideal confidence oracle. |

Loss decomposition: 0 candidate-recall loss, 144 ranking loss after recall,
71 confidence-calibration loss after a correct top-1, and 67 residual
false-strong outcomes. The ranking-signature classification has 22 rows with
no captured top/truth differential and 122 with metadata/weak-only differences;
neither establishes a safe deterministic reranking rule. This supports leaving
ranking untouched in this focused confidence change.

## Jev boundary (no Jev integration yet)

`js/pinpoint-jev-eligibility.js` provides a pure, cheap, fail-closed predicate:

```
candidate lattice
  -> deterministic ranking/evidence
  -> unresolved ambiguity only
  -> Jev assist
  -> fail-closed verdict
```

It can be eligible only when all of these are true: query mode is partial, the
lattice was deterministically marked complete, at least two candidates remain,
the local verdict is `ambiguous`, top/runner evidence signatures are unresolved,
and the caller independently marks the request high impact. It rejects exact
queries, strong local results, candidate-lattice failures, parser/lifter/function
extent failures, decisive deterministic evidence, malformed input, and low
impact. Timeout, invalid response, and low-confidence response handling must
return the unmodified local result; `fallbackToLocalPinpointResult` makes that
identity contract explicit.

For measurement only, treating every request as high impact yields **61**
eligible shapes (19 currently correct tops, 42 currently wrong tops). Of the
215 non-resolved selected-policy outcomes, **154** are outside this Jev
boundary: 43 exact weak/wrong outcomes, 67 partial strong-wrong outcomes, and
44 partial ambiguities with a deterministic evidence-signature difference.
Those counts mean “not improvable by this fail-closed Jev lane,” not a claim
that no future deterministic ranking or product-context work could help them.

## Production change and performance

Production changes only `decideFieldCandidates()`:

- Field `likely` permits `groups >= 3` or the exact metadata+structural pair.
- `confirmed`, candidate generation, fusion, score, ranking, and other
  Pinpoint paths remain unchanged.
- The predicate executes only for a field top that has already met existing
  likely score/margin gates and has fewer than three groups. It scans that top
  fusion's small evidence list; it performs no candidate-wide analysis, deep
  scan, decompile, or external call.

As a decision-only sanity check (200,000 synthetic calls, Node v24.20.0), the
median was 1.49 µs for the old direct decision and 2.97 µs for the field helper.
That approximately 1.48 µs branch cost includes option construction and strict
group validation; it is not a whole-analysis benchmark. In the measured corpus
the slow branch is relevant only to the 57 old-likely two-group rows, while
candidate generation/fusion/ranking and all binary analysis counts are unchanged.
The machine receipt is retained in persistent review evidence.

Focused regressions cover exact strong three-group evidence, partial ambiguity,
two versus three groups, wrong and correct top-1 behavior, metadata+structural,
candidate-present/not-found, malformed groups, and Jev fail-closed eligibility.

## Artifacts and reproduction

- `current-main-p1/measurement.json` — exact raw-measurement provenance.
- `current-main-p1/rows.jsonl` — row-level candidate/evidence snapshots.
- `current-main-p1/summary.json` and `policy-comparison.json` — policy metrics.
- `current-main-p1/old-vs-current.json` — machine-readable 54-row recall delta.
- `current-main-p1/failure-taxonomy.json`, `failure-rows.jsonl` — mutually
  exclusive failure classes.
- `current-main-p1/oracle-ceiling.json` and
  `ranking-oracle-classification.json` — oracle classification.
- `current-main-p1/jev-eligibility-analysis.json` — machine-testable Jev scope.

Reproduce collection with the verified fixtures, then aggregate and validate:

```sh
npm run fixtures:large
node --max-old-space-size=8000 scripts/measure-pinpoint-confidence.mjs \
  --out reports/investigations/pinpoint-confidence-plan-a/current-main-p1
node scripts/aggregate-pinpoint-confidence-plan-a.mjs \
  --out reports/investigations/pinpoint-confidence-plan-a/current-main-p1
node --test tests/investigate-pinpoint-confidence-plan-a.mjs
```

After committing, run `scripts/verify-pinpoint-confidence-plan-a-production.mjs`
from a clean exact head with `--evidence-out` pointing to persistent evidence.
It refuses to attest a dirty worktree and verifies the selected field verdict
against all 426 recorded rows without repeating binary analysis.
