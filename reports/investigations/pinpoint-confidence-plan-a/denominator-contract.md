# Plan-A denominator contract

- `fieldRows = 426`: exactly the query rows in
  `tests/fixtures/pinpoint-confidence-queries.json`.
- `exactRows = 230`; `partialRows = 196`; their sum is always 426.
- `dsdaHoldoutRows = 1`: a location-path holdout reported separately and never
  included in a field policy, recall, ranking, taxonomy, oracle, or Jev rate.
- `totalRows = 427`: field rows plus the one DSDA holdout.

Every field query remains in every field headline denominator, including a
query whose truth candidate is absent. Candidate-present and
candidate-not-found are explicit complementary subsets, never filters that
drop failed recall rows. Verdict tables count each row exactly once as
confirmed, likely, ambiguous, or none/not-found, and strong means confirmed or
likely only.

For the current-main collection, truth candidate presence is 426/426 overall,
230/230 exact, and 196/196 partial. The historical #9432 comparison keeps
its own 426-row denominator: its 54 partial not-found rows are reported as
rows, not removed before computing precision, ranking, or coverage.
